# 打包资源目录

打包 Windows 安装包前，可在此目录放置应用图标：

| 文件 | 说明 |
|------|------|
| `icon.ico` | 应用图标（推荐 256×256，含多尺寸） |

未提供图标时，electron-builder 将使用 Electron 默认图标。

**生成示例（ImageMagick）：**

```bash
magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```
