const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfReaderAPI', {
  openFileDialog:       () => ipcRenderer.invoke('open-file-dialog'),
  readPdfFile:          (fp) => ipcRenderer.invoke('read-pdf-file', fp),
  getPdfjsWorkerPath:   () => ipcRenderer.invoke('get-pdfjs-worker-path'),
  saveAnnotations:      (pdfPath, data) => ipcRenderer.invoke('save-annotations', { pdfPath, data }),
  loadAnnotations:      (pdfPath) => ipcRenderer.invoke('load-annotations', pdfPath),
  getAppVersion:        () => ipcRenderer.invoke('get-app-version'),
  onBeforeClose:        (fn) => ipcRenderer.on('app-before-close', () => fn()),
  allowClose:           () => ipcRenderer.send('app-allow-close')
});
