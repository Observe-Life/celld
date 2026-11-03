FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm i --registry=https://registry.npmmirror.com --silent
COPY check.js ./
# 常驻空壳：容器留在「正运行列表」里（镜像被活跃容器引用，不会被清理工具判定为无用），
# 真正吃内存的 node 工作进程由 celld-wake-container 按需 exec 拉起、跑完即退出。
CMD ["sh", "-c", "while :; do sleep 3600; done"]
