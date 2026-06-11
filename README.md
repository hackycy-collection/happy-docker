# happy

基于 Happy 仓库构建的 Docker 镜像并推送至腾讯云镜像仓库。

## 手动部署

```bash
TENCENT_USERNAME=xxxxxxxx TENCENT_PASSWORD='你的腾讯云镜像密码' node scripts/deploy.js latest
```

脚本会 clone 或更新上游 `slopus/happy` 到本地 `upstream/` 目录，并构建推送：

- `Dockerfile.webapp` -> `ccr.ccs.tencentyun.com/sooosin/happy-app:<tag>`
- `Dockerfile` -> `ccr.ccs.tencentyun.com/sooosin/happy-server:<tag>`

`upstream/` 已加入 `.gitignore`，不会被提交到当前仓库。

