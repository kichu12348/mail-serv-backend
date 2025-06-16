import express from "express";
import multer from "multer";
import sgMail from "@sendgrid/mail";
import fs from "fs";
import path from "path";
import {
  saveEmail,
  updateEmailStatus,
  getEmails,
  getEmailById,
  saveAttachment,
  deleteAttachmentsByEmailId,
  Email,
  Attachment,
} from "./db/db";

import dotenv from "dotenv";
dotenv.config();

// Check if SendGrid API key is defined
if (!process.env.SG_API_KEY) {
  console.error("SendGrid API key is not defined in environment variables");
  console.error("Please set SG_API_KEY environment variable");
  process.exit(1);
}

// Setup SendGrid
sgMail.setApiKey(process.env.SG_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create temporary uploads directory
const uploadsDir = path.join(__dirname, "temp_uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Enable CORS for frontend requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Configure multer for file uploads to disk instead of memory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Use a unique filename to avoid collisions
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
});

// Routes

// Get all emails
app.get("/emails", (req, res) => {
  try {
    const emails = getEmails();
    res.json(emails);
  } catch (error) {
    console.error("Error retrieving emails:", error);
    res.status(500).json({ error: "Failed to retrieve emails" });
  }
});

// Get specific email by ID
app.get("/emails/:id", (req: any, res: any) => {
  try {
    const emailId = parseInt(req.params.id, 10);
    const email = getEmailById(emailId);

    if (!email) {
      return res.status(404).json({ error: "Email not found" });
    }

    return res.json(email);
  } catch (error) {
    console.error("Error retrieving email:", error);
    return res.status(500).json({ error: "Failed to retrieve email" });
  }
});

// Send an email with attachments
app.post("/send", upload.array("attachments"), async (req: any, res: any) => {
  let emailId: number | undefined;
  const uploadedFiles: string[] = [];

  try {
    const { sender, recipients, subject, body, attachmentPaths } = req.body;
    const files = req.files as Express.Multer.File[];

    // Gather all paths - both directly uploaded files and chunked files
    const allFilePaths: string[] = [...(files?.map((f) => f.path) || [])];

    // Add attachment paths from chunked uploads if they exist
    if (attachmentPaths) {
      if (Array.isArray(attachmentPaths)) {
        allFilePaths.push(...attachmentPaths);
      } else {
        allFilePaths.push(attachmentPaths);
      }
    }

    // Validate required fields
    if (!sender || !recipients || !subject || !body) {
      return res.status(400).json({
        error: "Missing required fields: sender, recipients, subject, body",
      });
    }

    const recipientList = Array.isArray(recipients) ? recipients : [recipients];

    // Save email to database with 'pending' status
    const emailData: Email = {
      sender,
      recipients: recipientList,
      subject,
      body,
      status: "pending",
    };

    emailId = saveEmail(emailData);

    // Prepare email message
    const msg: any = {
      to: recipientList,
      from: sender,
      subject,
      text: body,
      html: body,
    };

    // Handle attachments if present
    if (allFilePaths.length > 0) {
      msg.attachments = [];

      for (const filePath of allFilePaths) {
        // Track files for cleanup
        uploadedFiles.push(filePath);

        try {
          // Read file info
          const fileContent = fs.readFileSync(filePath);
          const fileName = path
            .basename(filePath)
            .split("-")
            .slice(1)
            .join("-"); // Remove the file ID prefix
          const mimeType = getMimeType(filePath);

          // Save attachment metadata to database
          const attachment: Attachment = {
            emailId,
            filename: fileName,
            content: Buffer.from([]), // We're not storing the actual content in DB
            contentType: mimeType,
          };

          saveAttachment(attachment);

          // Add to email attachments
          msg.attachments.push({
            content: fileContent.toString("base64"),
            filename: fileName,
            type: mimeType,
            disposition: "attachment",
          });
        } catch (err) {
          console.error(`Error processing file ${filePath}:`, err);
        }
      }
    }

    // Send email
    await sgMail.send(msg);

    updateEmailStatus(emailId, "sent");

    // Clean up temporary files
    uploadedFiles.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete temporary file: ${filePath}`, err);
      }
    });

    deleteAttachmentsByEmailId(emailId);

    res.status(200).json({
      message: "Email sent successfully",
      emailId,
    });
  } catch (error: any) {
    console.error("Error sending email:", error);

    // If we have an emailId, update status to failed
    if (emailId) {
      updateEmailStatus(emailId, "failed");
    }

    // Clean up temporary files on error
    uploadedFiles.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete temporary file: ${filePath}`, err);
      }
    });

    res.status(500).json({
      error: "Failed to send email",
      details: error.message,
    });
  }
});

// Add a new endpoint for chunked file uploads
app.post(
  "/upload/chunk",
  express.raw({ limit: "50mb", type: "application/octet-stream" }),
  (req:any, res:any) => {
    try {
      const chunkIndex = parseInt(req.query.chunkIndex as string, 10);
      const totalChunks = parseInt(req.query.totalChunks as string, 10);
      const fileName = req.query.fileName as string;
      const fileId = req.query.fileId as string;

      if (isNaN(chunkIndex) || isNaN(totalChunks) || !fileName || !fileId) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      const chunkDir = path.join(uploadsDir, fileId);

      // Create directory for this file's chunks if it doesn't exist
      if (!fs.existsSync(chunkDir)) {
        fs.mkdirSync(chunkDir, { recursive: true });
      }

      const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);

      // Write chunk to disk
      fs.writeFileSync(chunkPath, req.body);

      res.status(200).json({
        success: true,
        message: `Chunk ${chunkIndex + 1} of ${totalChunks} received`,
      });
    } catch (error) {
      console.error("Error saving chunk:", error);
      res.status(500).json({ error: "Failed to save chunk" });
    }
  }
);

app.post("/upload/complete", express.json(), (req: any, res: any) => {
  try {
    const { fileId, fileName, totalChunks, mimeType } = req.body;

    if (!fileId || !fileName || !totalChunks || !mimeType) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const chunkDir = path.join(uploadsDir, fileId);
    const finalFilePath = path.join(uploadsDir, `${fileId}-${fileName}`);

    // Create a write stream for the final file
    const writeStream = fs.createWriteStream(finalFilePath);

    // Combine all chunks in order
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk-${i}`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);

      // Delete the chunk file after we've written its data
      fs.unlinkSync(chunkPath);
    }

    writeStream.end();

    // Remove the chunk directory
    fs.rmdirSync(chunkDir);

    res.status(200).json({
      success: true,
      message: "File upload complete",
      filePath: finalFilePath,
      fileName,
      mimeType,
    });
  } catch (error) {
    console.error("Error combining chunks:", error);
    res.status(500).json({ error: "Failed to combine chunks" });
  }
});

// Helper function to get MIME type
function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
  };

  return mimeTypes[extension] || "application/octet-stream";
}

// Start server
app.listen(PORT, () => {
  console.log(`Email service running on port ${PORT}`);
});
