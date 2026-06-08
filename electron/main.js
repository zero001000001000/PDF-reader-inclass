const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let allowCloseOnce = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1024,
    minHeight: 600,
    frame: true,
    fullscreenable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (allowCloseOnce) {
      allowCloseOnce = false;
      return;
    }
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-before-close');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[RENDERER] ${message}`);
  });
}

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 PDF 文件',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
});

ipcMain.handle('save-annotations', async (event, { pdfPath, data }) => {
  try {
    const dir = path.join(app.getPath('userData'), 'annotations');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const key = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
    const savePath = path.join(dir, `${key}.json`);
    fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('load-annotations', async (event, pdfPath) => {
  try {
    const key = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
    const savePath = path.join(app.getPath('userData'), 'annotations', `${key}.json`);
    if (!fs.existsSync(savePath)) return null;
    return JSON.parse(fs.readFileSync(savePath, 'utf-8'));
  } catch { return null; }
});

ipcMain.handle('read-pdf-file', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { data: buffer.buffer ? buffer.buffer : buffer, name: path.basename(filePath) };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('get-pdfjs-worker-path', async () => {
  const workerPath = path.join(__dirname, '..', 'lib', 'pdfjs', 'pdf.worker.min.mjs');
  return `file:///${workerPath.replace(/\\/g, '/')}`;
});

ipcMain.on('app-allow-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  allowCloseOnce = true;
  mainWindow.close();
});

ipcMain.handle('get-app-version', async () => {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    return pkg.version || app.getVersion();
  } catch {
    return app.getVersion();
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
