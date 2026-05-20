const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.use(cors({
  exposedHeaders: ['Content-Disposition', 'X-Saved-Percent']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

function runPythonWorker(task, files, args, res, downloadFilename = null) {
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  const workerPath = path.resolve(__dirname, '../python-backend/worker.py');
  
  const worker = spawn(pythonExecutable, [workerPath], {
    env: { ...process.env }
  });
  
  const inputData = {
    task,
    files,
    args,
    temp_dir: tempDir
  };
  
  let outputData = '';
  let errorData = '';

  worker.stdout.on('data', (data) => {
    outputData += data.toString();
  });

  worker.stderr.on('data', (data) => {
    errorData += data.toString();
  });

  worker.on('close', (code) => {
    if (code !== 0) {
      console.error('Python Error:', errorData);
      return res.status(500).json({ error: `Worker exited with code ${code}`, details: errorData });
    }
    
    try {
      // Find the last line that is valid JSON in case Python printed warnings
      const lines = outputData.trim().split('\n');
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          result = JSON.parse(lines[i]);
          break;
        } catch (e) {}
      }

      if (!result) {
        throw new Error("Could not parse worker output: " + outputData);
      }

      if (!result.success) {
        return res.status(500).json({ error: result.error, traceback: result.traceback });
      }

      // If it returns raw JSON data (e.g. summarize, translate)
      if (result.data) {
        return res.json(result.data);
      }

      // If it returns a file output
      if (result.output) {
        const filePath = result.output;
        if (!fs.existsSync(filePath)) {
          return res.status(500).json({ error: 'Output file not generated.' });
        }
        
        let filename = downloadFilename || path.basename(filePath);
        if (files.length > 0 && !downloadFilename) {
          const originalExt = path.extname(files[0]);
          const newExt = path.extname(filePath);
          const originalBase = path.basename(files[0], originalExt).split('_').slice(1).join('_');
          filename = `${originalBase}${newExt}`;
        }
        
        res.download(filePath, filename, (err) => {
          if (err) console.error("Download Error:", err);
          // Cleanup output file after sending
          try { fs.unlinkSync(filePath); } catch (e) {}
        });
      }
    } catch (e) {
      console.error('Parse Error:', e);
      res.status(500).json({ error: e.message, rawOutput: outputData });
    } finally {
      // Cleanup uploaded files
      files.forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });
    }
  });

  worker.stdin.write(JSON.stringify(inputData));
  worker.stdin.end();
}

// === ROUTES ===

app.get('/', (req, res) => res.json({ message: 'Node.js PDFSuite API is running' }));

// === CONTACT EMAIL ===
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body || {};

  if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const toEmail = process.env.CONTACT_TO_EMAIL || 'afaqmugha754@gmail.com';
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    return res.status(503).json({
      error: 'Email is not configured on the server. Add SMTP_USER and SMTP_PASS to your .env file (Gmail App Password recommended).',
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
    });

    await transporter.sendMail({
      from: `"ZeroWaveLabs Contact" <${smtpUser}>`,
      to: toEmail,
      replyTo: email,
      subject: `[Website Contact] ${subject}`,
      text: `Name: ${name}\nReply-To: ${email}\nSubject: ${subject}\n\n${message}`,
      html: `
        <h2>New contact message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        <p><strong>Subject:</strong> ${subject}</p>
        <hr>
        <p>${String(message).replace(/\n/g, '<br>')}</p>
      `,
    });

    return res.json({ success: true, message: 'Your message was sent successfully.' });
  } catch (err) {
    console.error('Contact email error:', err);
    return res.status(500).json({ error: 'Failed to send email. Check SMTP_USER and SMTP_PASS in .env.' });
  }
});

// ── helper: run qr_api.py ─────────────────────────────────────────────────
function runQrWorker(inputData, uploadedFiles, res, onSuccess) {
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.resolve(__dirname, '../python-backend/qr_api.py');
  const worker = spawn(pythonExecutable, [scriptPath], { env: { ...process.env } });

  let out = '', err = '';
  worker.stdout.on('data', d => { out += d.toString(); });
  worker.stderr.on('data', d => { err += d.toString(); });

  worker.on('close', code => {
    uploadedFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

    if (code !== 0) {
      console.error('QR Worker Error:', err);
      return res.status(500).json({ error: `QR worker exited with code ${code}`, details: err });
    }
    try {
      const lines = out.trim().split('\n');
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { result = JSON.parse(lines[i]); break; } catch (e) {}
      }
      if (!result) throw new Error('Could not parse QR worker output: ' + out);
      if (!result.success) return res.status(500).json({ error: result.error });
      onSuccess(result);
    } catch (e) {
      res.status(500).json({ error: e.message, rawOutput: out });
    }
  });

  worker.stdin.write(JSON.stringify(inputData));
  worker.stdin.end();
}

// === QR DECODE ROUTE ===
app.post('/api/qr/decode', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  const imagePath = req.file.path;

  runQrWorker(
    { action: 'decode', image_path: imagePath },
    [imagePath],
    res,
    result => res.json({ text: result.text, count: result.count, all: result.all, message: result.message })
  );
});

// === QR GENERATE ROUTE ===
app.post('/api/qr/generate', (req, res) => {
  const { text, size = 10, border = 4, fill_color = 'black', back_color = 'white', format = 'png' } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text/URL provided.' });

  const ext = format === 'svg' ? '.svg' : '.png';
  const outputPath = path.join(tempDir, `${Date.now()}_qr${ext}`);

  runQrWorker(
    { action: 'generate', text, size: parseInt(size), border: parseInt(border),
      fill_color, back_color, format, output_path: outputPath },
    [],
    res,
    result => {
      const filePath = result.output;
      if (!fs.existsSync(filePath)) return res.status(500).json({ error: 'QR file not generated.' });
      const mime = format === 'svg' ? 'image/svg+xml' : 'image/png';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="qr_code${ext}"`);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(filePath); } catch (e) {} });
    }
  );
});

const executeHandler = (req, res) => {
  const task = req.body.task || req.params.task || getTaskFromPath(req.path);
  if (!task) {
    return res.status(400).json({ error: "Task name is required" });
  }

  // Handle files safely from both single file upload, array upload, or multi-field upload
  let files = [];
  if (req.file) {
    files = [req.file.path];
  } else if (req.files) {
    if (Array.isArray(req.files)) {
      files = req.files.map(f => f.path);
    } else {
      // For object fields (like pdf-edit with 'file' and 'edit_image')
      for (const fieldName in req.files) {
        req.files[fieldName].forEach(f => files.push(f.path));
      }
    }
  }

  const args = { ...req.body };
  delete args.task; // remove from args

  let downloadFilename = null;
  if (task === 'pdf-merge') downloadFilename = 'merged_document.pdf';
  else if (task === 'image-to-pdf') downloadFilename = 'images_converted.pdf';
  else if (task === 'html-to-pdf') downloadFilename = 'html_converted.pdf';
  else if (task === 'gmaps-scraper') downloadFilename = 'business_leads.xlsx';
  else if (task === 'word-to-excel') downloadFilename = 'word_converted.xlsx';

  runPythonWorker(task, files, args, res, downloadFilename);
};

function getTaskFromPath(urlPath) {
  if (urlPath.includes('word-to-pdf')) return 'word-to-pdf';
  if (urlPath.includes('word-to-excel')) return 'word-to-excel';
  if (urlPath.includes('pdf-to-ppt')) return 'pdf-to-ppt';
  if (urlPath.includes('pdf-to-image')) return 'pdf-to-image';
  if (urlPath.includes('pdf-to-excel')) return 'pdf-to-excel';
  if (urlPath.includes('pdf-to-word')) return 'pdf-to-word';
  if (urlPath.includes('pdf-merge')) return 'pdf-merge';
  if (urlPath.includes('pdf-split')) return 'pdf-split';
  if (urlPath.includes('pdf-compress')) return 'pdf-compress';
  if (urlPath.includes('image-to-pdf')) return 'image-to-pdf';
  if (urlPath.includes('pdf-protect')) return 'pdf-protect';
  if (urlPath.includes('pdf-unlock')) return 'pdf-unlock';
  if (urlPath.includes('pdf-rotate')) return 'pdf-rotate';
  if (urlPath.includes('pdf-watermark')) return 'pdf-watermark';
  if (urlPath.includes('pdf-edit')) return 'pdf-edit';
  if (urlPath.includes('html-to-pdf')) return 'html-to-pdf';
  if (urlPath.includes('summarize')) return 'summarize';
  if (urlPath.includes('translate')) return 'translate';
  if (urlPath.includes('gmaps-scraper')) return 'gmaps-scraper';
  return null;
}

// Single Unified execution API
app.post('/api/execute', upload.any(), executeHandler);

// Backward Compatibility Aliases (maps all old frontend endpoints to the same handler!)
app.post('/api/convert/word-to-pdf', upload.single('file'), executeHandler);
app.post('/api/convert/word-to-excel', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-to-ppt', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-to-image', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-to-excel', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-to-word', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-merge', upload.array('files'), executeHandler);
app.post('/api/convert/pdf-split', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-compress', upload.single('file'), executeHandler);
app.post('/api/convert/image-to-pdf', upload.array('files'), executeHandler);
app.post('/api/convert/pdf-protect', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-unlock', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-rotate', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-watermark', upload.single('file'), executeHandler);
app.post('/api/convert/pdf-edit', upload.fields([{name:'file'}, {name:'edit_image'}]), executeHandler);
app.post('/api/convert/html-to-pdf', upload.single('file'), executeHandler);
app.post('/api/intelligence/summarize', upload.single('file'), executeHandler);
app.post('/api/intelligence/translate', upload.single('file'), executeHandler);
app.post('/api/automation/gmaps-scraper', upload.none(), executeHandler);


const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Node.js Unified Backend running on port ${PORT}`);
});
