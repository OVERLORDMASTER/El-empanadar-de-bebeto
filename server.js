const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── DETECCIÓN DE CARPETA DE DATOS ─────────────
// Si existe la variable RENDER_DISK_PATH (disco persistente), se usa.
// Si no, se usa la carpeta local (desarrollo o Render sin disco).
const DATA_DIR = process.env.RENDER_DISK_PATH || __dirname;

const LOADS_DIR = path.join(DATA_DIR, 'loadspro');

// Crear carpeta loadspro si no existe
if (!fs.existsSync(LOADS_DIR)) {
    try {
        fs.mkdirSync(LOADS_DIR, { recursive: true });
        console.log('✅ Carpeta loadspro creada en:', LOADS_DIR);
    } catch (error) {
        console.error('❌ No se pudo crear la carpeta loadspro:', error.message);
        process.exit(1);
    }
}

// Verificar permisos de escritura
try {
    fs.accessSync(LOADS_DIR, fs.constants.W_OK);
    const testFile = path.join(LOADS_DIR, '.test_write');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Permisos de escritura en loadspro correctos');
} catch (error) {
    console.error('❌ No se tienen permisos de escritura en', LOADS_DIR);
    process.exit(1);
}

// ─── MIDDLEWARE ─────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // archivos HTML/CSS/JS
app.use('/loadspro', express.static(LOADS_DIR));

// ─── MULTER ────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const tipos = /jpeg|jpg|png|gif|webp/;
        const ext = tipos.test(path.extname(file.originalname).toLowerCase());
        const mime = tipos.test(file.mimetype);
        if (ext && mime) return cb(null, true);
        cb(new Error('Formato no permitido. Solo: jpg, png, gif, webp'));
    }
});

const uploadMiddleware = (req, res, next) => {
    upload.single('imagen')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
    });
};

// ─── BASE DE DATOS ─────────────────────────────
const DB_PATH = path.join(DATA_DIR, 'productos.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio_usd REAL NOT NULL,
    caracteristica TEXT NOT NULL,
    imagen TEXT
)`);

// ─── API REST ──────────────────────────────────
app.get('/api/productos', (req, res) => {
    const productos = db.prepare('SELECT * FROM productos ORDER BY nombre').all();
    res.json(productos.map(p => ({
        ...p,
        imagen: p.imagen ? `/loadspro/${p.imagen}` : null
    })));
});

app.post('/api/productos', uploadMiddleware, (req, res) => {
    const { nombre, precio_usd, caracteristica } = req.body;
    if (!nombre || !precio_usd || !caracteristica) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const imagen = req.file ? req.file.filename : null;
    const stmt = db.prepare('INSERT INTO productos (nombre, precio_usd, caracteristica, imagen) VALUES (?,?,?,?)');
    const result = stmt.run(nombre, precio_usd, caracteristica, imagen);
    res.status(201).json({ id: result.lastInsertRowid, nombre, precio_usd, caracteristica, imagen });
});

app.put('/api/productos/:id', uploadMiddleware, (req, res) => {
    const { id } = req.params;
    const { nombre, precio_usd, caracteristica } = req.body;
    const nuevaImagen = req.file ? req.file.filename : undefined;
    if (nuevaImagen) {
        db.prepare('UPDATE productos SET nombre=?, precio_usd=?, caracteristica=?, imagen=? WHERE id=?')
            .run(nombre, precio_usd, caracteristica, nuevaImagen, id);
    } else {
        db.prepare('UPDATE productos SET nombre=?, precio_usd=?, caracteristica=? WHERE id=?')
            .run(nombre, precio_usd, caracteristica, id);
    }
    res.json({ mensaje: 'Producto actualizado' });
});

app.delete('/api/productos/:id', (req, res) => {
    db.prepare('DELETE FROM productos WHERE id=?').run(req.params.id);
    res.json({ mensaje: 'Producto eliminado' });
});

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
});

// ─── INICIAR ───────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Estáticos: ${__dirname}`);
    console.log(`🖼️ Imágenes: ${LOADS_DIR}`);
    console.log(`🗄️ DB: ${DB_PATH}`);
});
