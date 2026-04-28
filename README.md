# Context Token Meter

SillyTavern 第三方前端扩展。

作用：

- 以最高层浮动方式显示 token 用量，避免被聊天框附近控件遮挡
- 使用液态 3D 竖向柱形进度条，并在同一个柱体中叠加三段信息
- 上下文：按设置读取最近 N 条聊天消息并统计 token
- 发送包：读取提示词查看器 / SillyTavern 生成缓存里的实际发送 prompt token
- 合计：显示上下文 + 发送包的总 token，并按最高 token 上限计算百分比
- 插件会用 SillyTavern 的 dry-run 组包主动刷新发送包 token；输入停顿后触发，并带有冷却时间，不会每秒请求
- 扩展设置里可用 X / Y 滑条拖动调整悬浮位置
- 扩展设置里可切换竖条 / 横条样式，横条适合放在手机输入区上方
- 扩展设置里可自定义上下文段和发送包段的颜色
- 扩展设置里可修改最高 token 和读取最近消息数

安装方式：

1. 将本仓库内容放到 `SillyTavern/public/scripts/extensions/third-party/context-token-meter/`
2. 刷新 SillyTavern 页面
3. 在扩展列表里启用该扩展

文件：

- `manifest.json`
- `index.js`
- `style.css`
