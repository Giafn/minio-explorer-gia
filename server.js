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

const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 60000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

async function getConnection() {
  return await oracledb.getConnection(dbConfig);
}

const FILE_QUERY = `(SELECT EVIDENCE_PATH AS PATH, CREATED_BY, DOC_TYPES AS DOC_TYPE, XS1, TO_CHAR(CREATED_DTM, 'YYYY-MM-DD') AS CREATED_DATE FROM DOCUMENT_FILES
UNION ALL
SELECT '/FILE' || R_GLOBAL_TYPE_VALUE.NAME || M_ATTACHMENT.FILE_NAME AS PATH, M_ATTACHMENT.CREATED_BY, M_ATTACHMENT.CATEGORY AS DOC_TYPE, NULL AS XS1, TO_CHAR(M_ATTACHMENT.CREATED_DATE, 'YYYY-MM-DD') AS CREATED_DATE
FROM M_ATTACHMENT JOIN R_GLOBAL_TYPE_VALUE ON M_ATTACHMENT.PATH_FILE = R_GLOBAL_TYPE_VALUE.GLB_VALUE
UNION ALL
SELECT PATH, CREATED_BY, 'TEMPLATE' AS DOC_TYPE, NULL AS XS1, TO_CHAR(CREATED_DATE, 'YYYY-MM-DD') AS CREATED_DATE FROM M_GENERAL_TEMPLATE)`;

const FETCH_OPTS = { fetchTypeHandler: (m) => { if (m.dbType === oracledb.DB_TYPE_DATE) return { type: oracledb.STRING }; } };

function mapRow(row) {
  return { path: row[0], name: row[0].split('/').pop(), createdBy: row[1], docType: row[2], xs1: row[3], createdDate: row[4] };
}

// Ambil semua file (untuk search)
let allFileCache = null;
let allFileCacheTime = 0;
async function fetchAllFiles() {
  const now = Date.now();
  if (allFileCache && now - allFileCacheTime < CACHE_TTL) return allFileCache;
  const conn = await getConnection();
  const res = await conn.execute(`SELECT * FROM ${FILE_QUERY}`, [], FETCH_OPTS);
  allFileCache = res.rows.map(mapRow);
  allFileCacheTime = now;
  await conn.close();
  return allFileCache;
}

// Ambil folder saja (untuk sidebar tree) - sangat ringan
let folderCache = null;
let folderCacheTime = 0;
async function fetchFolders() {
  const now = Date.now();
  if (folderCache && now - folderCacheTime < CACHE_TTL) return folderCache;
  const conn = await getConnection();
  const res = await conn.execute(`SELECT DISTINCT SUBSTR(PATH, 1, INSTR(PATH, '/', 1, LEVEL)) AS FOLDER FROM (${FILE_QUERY}) CONNECT BY PRIOR PATH = SUBSTR(PATH, 1, INSTR(PATH, '/', 1, LEVEL) - 1) START WITH PATH LIKE '%/'`);
  folderCache = res.rows.map(r => r[0]);
  folderCacheTime = now;
  await conn.close();
  return folderCache;
}

// Ambil file per folder saja - ringan
let dirFileCache = {};
let dirFileCacheTime = {};
async function fetchFilesByDir(dirPath) {
  const now = Date.now();
  const cacheKey = dirPath;
  if (dirFileCache[cacheKey] && now - dirFileCacheTime[cacheKey] < CACHE_TTL) return dirFileCache[cacheKey];
  const conn = await getConnection();
  const prefix = dirPath === '/' ? '/' : dirPath + '/';
  const res = await conn.execute(
    `SELECT * FROM ${FILE_QUERY} WHERE PATH LIKE :p1 OR PATH LIKE :p2`,
    [prefix + '%', dirPath === '/' ? '%/' : dirPath],
    FETCH_OPTS
  );
  const files = res.rows.map(mapRow).filter(f => {
    const rel = f.path.replace(/^\/+/, '');
    const dirOnly = dirPath === '/' ? '' : dirPath.replace(/^\/+/, '') + '/';
    const relNoDir = rel.replace(dirOnly, '');
    return !relNoDir.includes('/') || (dirPath === '/' && !rel.includes('/'));
  });
  dirFileCache[cacheKey] = files;
  dirFileCacheTime[cacheKey] = now;
  await conn.close();
  return files;
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
  allFileCache = null; allFileCacheTime = 0;
  folderCache = null; folderCacheTime = 0;
  dirFileCache = {}; dirFileCacheTime = {};
  try {
    await fetchAllFiles();
    res.json({ ok: true, count: allFileCache.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: get directory listing for a path (hanya file di folder ini)
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
      name: f.name, path: f.path, type: 'file', docType: f.docType,
      createdBy: f.createdBy, createdDate: f.createdDate, xs1: f.xs1
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

// API: delete file from MinIO
app.delete('/api/delete', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  try {
    await minioClient.removeObject(BUCKET, filePath);
    allFileCache = null; allFileCacheTime = 0;
    dirFileCache = {}; dirFileCacheTime = {};
    res.json({ ok: true });
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
