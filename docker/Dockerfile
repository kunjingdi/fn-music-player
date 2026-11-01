# 飞牛音乐 · 服务端（一份代码，两个镜像）
#
# 构建上下文 = 仓库根目录
#   docker build -f docker/Dockerfile --target full -t fn-music:full .
#   docker build -f docker/Dockerfile --target dl   -t fn-music:dl   .
#
# 两个镜像共用同一份代码，靠环境变量 MODE 分流：
#   MODE=full  自带曲库 + 播放接口 /api/d/* + 播放器页面
#   MODE=dl    只有搜歌下载页面，不加载曲库、不提供 /api/d/*（客户端自动发现不会命中）
#
# 红线：镜像里不能有任何密钥 / 个人数据。
#       config.local.json、settings.json、.device_id 一律由 .dockerignore 排除。

FROM node:20-alpine AS base

ENV NODE_ENV=production \
    PORT=8530 \
    FN_HOST=0.0.0.0 \
    FN_MUSIC_DATA_DIR=/data \
    FN_MUSIC_NO_AUTOSTART=1 \
    TZ=Asia/Shanghai

RUN apk add --no-cache tzdata tini && mkdir -p /app /data

WORKDIR /app

# 先装依赖，利用层缓存：只改代码时不用重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 只拷运行必需文件。切勿 COPY 整个目录，否则 config.local.json 会进镜像。
# icon_512.png 是「没有内嵌封面的歌」的兜底封面（规范 5.3 要求必须 200 + 图）
COPY server.cjs library.cjs downloader.cjs index.html download.html icon_512.png ./

EXPOSE 8530
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8530)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini","--"]

# ── 完整版：曲库 + 播放 + 在线下载 ──
FROM base AS full
ENV MODE=full \
    MUSIC_DIR=/music
VOLUME ["/music"]
CMD ["node","server.cjs"]

# ── 纯下载版：只有搜歌下载，没有 /api/d/* ──
FROM base AS dl
ENV MODE=dl
CMD ["node","server.cjs"]
