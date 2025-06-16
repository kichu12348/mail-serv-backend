import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure the data directory exists
const dataDir = path.join(__dirname,'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const db = new Database(path.join(dataDir, 'emails.db'));

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipients TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content BLOB NOT NULL,
    content_type TEXT NOT NULL,
    FOREIGN KEY (email_id) REFERENCES emails(id)
  );
`);

// Types
export interface Email {
  id?: number;
  sender: string;
  recipients: string[];
  subject: string;
  body: string;
  sentAt?: Date;
  status: 'pending' | 'sent' | 'failed';
}

export interface Attachment {
  id?: number;
  emailId: number;
  filename: string;
  content: Buffer;
  contentType: string;
}

// Email operations
export const saveEmail = (email: Email): number => {
  const { sender, recipients, subject, body, status } = email;
  
  const stmt = db.prepare(`
    INSERT INTO emails (sender, recipients, subject, body, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    sender, 
    JSON.stringify(recipients), 
    subject, 
    body, 
    status
  );
  
  return Number(result.lastInsertRowid);
};

export const updateEmailStatus = (id: number, status: 'pending' | 'sent' | 'failed'): void => {
  const stmt = db.prepare('UPDATE emails SET status = ? WHERE id = ?');
  stmt.run(status, id);
};

export const getEmails = (): Email[] => {
  const stmt = db.prepare('SELECT * FROM emails ORDER BY sent_at DESC');
  const rows = stmt.all() as any[];
  
  return rows.map(row => ({
    id: row.id,
    sender: row.sender,
    recipients: JSON.parse(row.recipients),
    subject: row.subject,
    body: row.body,
    sentAt: new Date(row.sent_at),
    status: row.status
  }));
};

export const getEmailById = (id: number): Email | null => {
  const stmt = db.prepare('SELECT * FROM emails WHERE id = ?');
  const row = stmt.get(id) as any;
  
  if (!row) return null;
  
  return {
    id: row.id,
    sender: row.sender,
    recipients: JSON.parse(row.recipients),
    subject: row.subject,
    body: row.body,
    sentAt: new Date(row.sent_at),
    status: row.status
  };
};

// Attachment operations
export const saveAttachment = (attachment: Attachment): number => {
  const { emailId, filename, content, contentType } = attachment;
  
  const stmt = db.prepare(`
    INSERT INTO attachments (email_id, filename, content, content_type)
    VALUES (?, ?, ?, ?)
  `);
  
  const result = stmt.run(emailId, filename, content, contentType);
  return Number(result.lastInsertRowid);
};

export const getAttachmentsByEmailId = (emailId: number): Attachment[] => {
  const stmt = db.prepare('SELECT * FROM attachments WHERE email_id = ?');
  const rows = stmt.all(emailId) as any[];
  
  return rows.map(row => ({
    id: row.id,
    emailId: row.email_id,
    filename: row.filename,
    content: row.content,
    contentType: row.content_type
  }));
};

export const deleteAttachmentsByEmailId = (emailId: number): void => {
  const stmt = db.prepare('DELETE FROM attachments WHERE email_id = ?');
  stmt.run(emailId);
};

export default db;
