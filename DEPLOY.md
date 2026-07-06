# 5 分钟上线 Render

## 第一步：把项目传到 GitHub

在项目目录执行：

```bash
git add .
git commit -m "prepare render deploy"
```

然后创建 GitHub 仓库并推送。

## 第二步：到 Render 部署

1. 打开 `https://render.com`
2. 登录后点 `New`
3. 选择 `Blueprint`
4. 连接你的 GitHub 仓库
5. 选择这个项目仓库
6. 确认 Render 读取到根目录的 `render.yaml`
7. 点击部署

## 第三步：拿到公网网址

部署成功后，Render 会给你一个：

```text
https://xxxx.onrender.com
```

这就是以后直接访问的网站链接。

## 如果部署后打不开

先检查 Render 页面里这三项：

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/healthz`

## 当前版本注意事项

- 识别记录和闹钟数据目前保存在服务器本地文件
- 重新部署或更换服务器后，数据可能丢失
- 如果要长期正式使用，下一步建议改数据库
