/**
 * setup-pdfjs.js
 * 将 pdfjs-dist 的离线文件提取到 lib/pdfjs/ 目录
 * 作为 postinstall 脚本自动运行
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PDFJS_SRC = path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'build');
const PDFJS_DEST = path.join(PROJECT_ROOT, 'lib', 'pdfjs');

const FILES_TO_COPY = [
  // pdfjs-dist 4.x 使用 ES module 格式（mjs）
  { src: 'pdf.min.mjs', dest: 'pdf.min.mjs' },
  { src: 'pdf.worker.min.mjs', dest: 'pdf.worker.min.mjs' }
];

function main() {
  // 创建目标目录
  if (!fs.existsSync(PDFJS_DEST)) {
    fs.mkdirSync(PDFJS_DEST, { recursive: true });
  }

  let copied = 0;
  let missing = [];

  for (const file of FILES_TO_COPY) {
    const srcPath = path.join(PDFJS_SRC, file.src);
    const destPath = path.join(PDFJS_DEST, file.dest);

    if (!fs.existsSync(srcPath)) {
      missing.push(file.src);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    copied++;
    console.log(`  ✓ ${file.src} → lib/pdfjs/${file.dest}`);
  }

  if (missing.length > 0) {
    console.warn(`  ⚠ 以下文件未找到 (需在 PDF-reader-inclass 目录下运行 npm install): ${missing.join(', ')}`);
  }

  console.log(`\n完成: 复制 ${copied}/${FILES_TO_COPY.length} 个文件到 lib/pdfjs/`);

  if (copied === FILES_TO_COPY.length) {
    console.log('pdf.js 离线包就绪 ✓');
  }
}

main();
