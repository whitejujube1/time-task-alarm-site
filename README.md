# 时间任务提取与闹钟网站

这是一个可部署的 Node.js 网站项目。部署到服务器后，你只需要打开一个固定网址，就可以随时访问它，而不需要每次手动本地启动再使用。

## 网站能力

- 上传 `TXT / Word(.docx) / PDF / Excel(.xlsx/.xls) / 图片`
- 自动 OCR 和时间任务提取
- 支持人工修改提取结果
- 一键批量创建闹钟
- 网站内闹钟管理：修改、删除、延后、完成、关闭
- 识别记录和闹钟记录持久化保存

## 技术栈

- Node.js 20+
- Express
- `npm install && npm start` 可直接运行
- 服务监听 `0.0.0.0:3000`

## 本地运行

```bash
npm install
npm start
```

浏览器打开：

```text
http://127.0.0.1:3000
```

## 按 Render 部署

项目已经补好了 Render 用的部署文件：

- [render.yaml](/root/12345/render.yaml)
- [.node-version](/root/12345/.node-version)
- [DEPLOY.md](/root/12345/DEPLOY.md)

### 最短部署步骤

1. 把项目推到 GitHub
2. 打开 Render 控制台
3. 选择 `New -> Blueprint`
4. 连接你的 GitHub 仓库
5. 让 Render 读取仓库根目录下的 `render.yaml`
6. 点击部署

部署后，Render 会为你生成一个 `onrender.com` 公网地址，这就是你以后直接访问的网站链接。

如果你想走最短路线，直接看：

- [DEPLOY.md](/root/12345/DEPLOY.md)

### 当前 Render 配置

- Runtime: `node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/healthz`
- Node 版本: `20`

### 关于数据持久化

当前项目把识别记录和闹钟记录保存到本地文件：

- `data/records.json`
- `data/alarms.json`

我已经把数据目录改成可由 `DATA_DIR` 环境变量控制，便于后续接持久化存储。

但这里有一个重要限制：

- 如果你使用的是不带持久磁盘的部署方式，服务重启或重新部署后，这些本地文件数据可能丢失

因此这份 Render 配置适合：

- 先快速部署演示
- 先拿到一个可访问网址

如果你准备正式长期使用，建议下一步改成数据库存储。

## 当前数据保存方式

- 识别记录：`data/records.json`
- 闹钟记录：`data/alarms.json`

这意味着：

- 部署后网站可以正常保存数据
- 但如果换服务器或清空磁盘，本地文件数据会丢失

如果后续你要正式上线给多人使用，建议下一步把数据存储改成数据库，例如：

- SQLite
- PostgreSQL
- MySQL

## 目录说明

- [server.js](/root/12345/server.js): 后端接口、文件解析、时间提取、闹钟调度
- [public/index.html](/root/12345/public/index.html): 网站页面结构
- [public/app.js](/root/12345/public/app.js): 前端交互逻辑
- [public/styles.css](/root/12345/public/styles.css): 页面样式

## 当前提醒说明

当前网站提醒机制分两层：

1. 服务器保存闹钟并定时触发
2. 浏览器打开网站时，页面会弹出提醒窗口

如果浏览器授予了通知权限，还会显示系统通知。

## 下一步建议

如果你要把它真正变成“可以随时访问的正式网站”，下一步最值得做的是：

1. 接入数据库
2. 增加账号系统
3. 把提醒从“网页打开时提醒”升级成“邮件 / 短信 / 微信 / Telegram”等服务端通知
4. 正式部署到一个公网域名
