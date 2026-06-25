require('dotenv').config();
const express = require('express');
const oracledb = require('oracledb');
const { Client } = require('minio');
const path = require('path');

oracledb.initOracleClient({ libDir: process.env.ORACLE_LIB_DIR });

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

const minioConfig = {
  endPoint: process.env.MINIO_ENDPOINT,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
  useSSL: process.env.MINIO_USE_SSL === 'true'
};

const minioClient = new Client(minioConfig);
const BUCKET = process.env.MINIO_BUCKET;

const dbConfig = {
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: process.env.ORACLE_CONNECT_STRING
};

let fileCache = null;
let cacheTime = 0;
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 60000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

async function fetchAllFiles() {
  const now = Date.now();
  if (fileCache && now - cacheTime < CACHE_TTL) return fileCache;

  const connection = await oracledb.getConnection(dbConfig);
  const result = await connection.execute(
    'SELECT EVIDENCE_PATH, CREATED_BY, DOC_TYPES, XS1, CREATED_DTM as CREATED_DATE FROM DOCUMENT_FILES'
  );
  const docFiles = result.rows.map(row => ({
    path: row[0],
    name: row[0].split('/').pop(),
    createdBy: row[1],
    docType: row[2],
    xs1: row[3],
    createdDate: row[4] ? new Date(row[4]).toISOString().slice(0, 10) : null
  }));

  const attResult = await connection.execute(
    `SELECT '/FILE' || R_GLOBAL_TYPE_VALUE.NAME || M_ATTACHMENT.FILE_NAME AS PATH,
            M_ATTACHMENT.CATEGORY,
            M_ATTACHMENT.CREATED_BY,
            TO_CHAR(M_ATTACHMENT.CREATED_DATE, 'YYYY-MM-DD') AS CREATED_DATE
     FROM M_ATTACHMENT
     JOIN R_GLOBAL_TYPE_VALUE ON M_ATTACHMENT.PATH_FILE = R_GLOBAL_TYPE_VALUE.GLB_VALUE`
  );
  const attFiles = attResult.rows.map(row => ({
    path: row[0],
    name: row[0].split('/').pop(),
    createdBy: row[2],
    docType: row[1],
    xs1: null,
    createdDate: row[3]
  }));

  await connection.close();
  fileCache = [...docFiles, ...attFiles];
  cacheTime = now;
  return fileCache;
}

function buildTree(files) {
  const root = { name: '/', children: {}, files: [] };
  files.forEach(file => {
    const parts = file.path.replace(/^\//, '').split('/');
    let current = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        current.files.push(file);
      } else {
        if (!current.children[part]) {
          current.children[part] = { name: part, children: {}, files: [] };
        }
        current = current.children[part];
      }
    });
  });
  return root;
}

function getNode(tree, dirPath) {
  if (!dirPath || dirPath === '/') return tree;
  const parts = dirPath.replace(/^\//, '').split('/');
  let current = tree;
  for (const part of parts) {
    if (!current.children[part]) return null;
    current = current.children[part];
  }
  return current;
}

// API: force refresh cache
app.get('/api/refresh', async (req, res) => {
  fileCache = null;
  cacheTime = 0;
  try {
    await fetchAllFiles();
    res.json({ ok: true, count: fileCache.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: get directory listing for a path
app.get('/api/list', async (req, res) => {
  const dirPath = req.query.path || '/';
  try {
    const files = await fetchAllFiles();
    const tree = buildTree(files);
    const node = getNode(tree, dirPath);
    if (!node) return res.status(404).json({ error: 'Directory not found' });

    const dirs = Object.values(node.children).map(d => ({
      name: d.name,
      path: (dirPath === '/' ? '/' : dirPath + '/') + d.name,
      type: 'directory'
    }));

    const fileItems = node.files.map(f => ({
      name: f.name,
      path: f.path,
      type: 'file',
      docType: f.docType,
      createdBy: f.createdBy,
      createdDate: f.createdDate,
      xs1: f.xs1
    }));

    res.json({ path: dirPath, directories: dirs, files: fileItems });
  } catch (error) {
    console.error('Error listing directory:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: get full tree structure
app.get('/api/tree', async (req, res) => {
  try {
    const files = await fetchAllFiles();
    const tree = buildTree(files);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: download file from MinIO
app.get('/api/download', async (req, res) => {
  const filePath = req.query.path;
  try {
    const stream = await minioClient.getObject(BUCKET, filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: preview file from MinIO
app.get('/api/preview', async (req, res) => {
  const filePath = req.query.path;
  try {
    const stream = await minioClient.getObject(BUCKET, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.txt': 'text/plain', '.csv': 'text/csv',
      '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(port, () => {
  console.log(`MinIO File Explorer running on http://localhost:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
