# Context Token Meter

SillyTavern 第三方前端扩展。

作用：

- 在聊天输入框右侧显示当前上下文 token 用量
- 使用分段式液态 3D 进度条
- 优先读取 SillyTavern 实际生成缓存的上下文 token
- 没有缓存时退回到当前聊天内容估算

安装方式：

1. 将本仓库内容放到 `SillyTavern/public/scripts/extensions/third-party/context-token-meter/`
2. 刷新 SillyTavern 页面
3. 在扩展列表里启用该扩展

文件：

- `manifest.json`
- `index.js`
- `style.css`
