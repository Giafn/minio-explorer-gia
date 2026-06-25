const express = require('express');
const oracledb = require('oracledb');
const { Client } = require('minio');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('.'));

const minioConfig = {
  endPoint: 'miniodev-api.pgn.co.id',
  accessKey: 'ImkHGLJJxQZnFLblcvm1',
  secretKey: 'nEUkCuzZsdcj82jWj9pwX7W3lKQMRVq5oFmQ7jya',
  useSSL: true
};

const minioClient = new Client(minioConfig);

// Database configuration from info.md
const dbConfig = {
  user: 'PGNENERGYSTG',
  password: 'M3abj_#Jo=8kyu9)Sb',
  connectString: 'oracle:thin:@10.129.2.173:1523:PDEV'
};

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API endpoint to get all files from DOCUMENT_FILES table
app.get('/api/files', async (req, res) => {
  try {
    const connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(
      'SELECT EVIDENCE_PATH, CREATED_BY, DOC_TYPES, XS1 FROM DOCUMENT_FILES ORDER BY id'
    );
    const files = result.rows.map(row => {
      const path = row[0];
      const fileName = path.split('/').pop() || path;
      return {
        path: path,
        name: fileName,
        createdBy: row[1],
        docType: row[2],
        xs1: row[3]
      };
    });
    await connection.close();
    res.json(files);
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files from database' });
  }
});

// API endpoint to check if file exists in MinIO
app.get('/api/check-file', async (req, res) => {
  const { bucket, path } = req.query;
  try {
    const exists = await minioClient.statObject(bucket || 'shg-crm', path);
    res.json({ exists: true, size: exists.size });
  } catch (error) {
    if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
      res.json({ exists: false });
    } else {
      console.error('Error checking MinIO file:', error);
      res.json({ exists: false, error: error.code });
    }
  }
});

app.listen(port, () => {
  console.log(`MinIO File Explorer server running on port ${port}`);
});

// Test function to verify the application
function runTest() {
  console.log('Testing MinIO File Explorer...');
  console.log('Server should be running on port 3000');
  console.log('Endpoints available:');
  console.log('  - GET /api/files - Get all files from database (DOCUMENT_FILES.EVIDENCE_PATH)');
  console.log('  - GET /api/check-file?bucket=BUCKET&path=PATH - Check if file exists in MinIO');
  console.log('  - GET /health - Health check');
  console.log('\nTo test the application:');
  console.log('  1. Start the server: npm start');
  console.log('  2. Access: http://localhost:3000');
  console.log('  3. The UI will fetch data from /api/files and display all files');
}

if (require.main === module) {
  runTest();
}
