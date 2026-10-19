#!/usr/bin/env bash
# 生成本地自签证书（阶段 7 T7.3）：给局域网手机访问用。
# 为什么不用 mkcert：本机没装、也不希望为自用项目引入 go 二进制；
# openssl 是 Git for Windows 自带的，够用且步骤可复现。
#
# 用法：bash server/scripts/make-cert.sh [局域网IP ...]
#   例：bash server/scripts/make-cert.sh 192.168.0.101
# 产物（已被 .gitignore 忽略）：certs/ca.crt ca.key server.crt server.key
set -euo pipefail

cd "$(dirname "$0")/../.."
OPENSSL="${OPENSSL:-/c/Program Files/Git/usr/bin/openssl.exe}"
[ -x "$OPENSSL" ] || OPENSSL="openssl"

IPS=("$@")
if [ ${#IPS[@]} -eq 0 ]; then
  echo "用法：bash server/scripts/make-cert.sh <局域网IP> [更多IP...]"
  echo "查本机局域网 IP：ipconfig | findstr IPv4"
  exit 1
fi

SAN="DNS:localhost,DNS:pantry.local,IP:127.0.0.1"
for ip in "${IPS[@]}"; do SAN="$SAN,IP:$ip"; done

mkdir -p certs
echo "== 1/3 根证书 CA（10 年）"
"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout certs/ca.key -out certs/ca.crt \
  -subj "/C=CN/O=Pantry Local/CN=Pantry Local CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

echo "== 2/3 服务器私钥与 CSR（CN 用第一个 IP，真正生效的是 SAN）"
"$OPENSSL" req -newkey rsa:2048 -sha256 -nodes \
  -keyout certs/server.key -out certs/server.csr \
  -subj "/C=CN/O=Pantry Local/CN=${IPS[0]}" 2>/dev/null

echo "== 3/3 用 CA 签发服务器证书（825 天，苹果/安卓对长有效期更宽容）"
cat > certs/san.cnf <<EOF
subjectAltName=$SAN
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF
"$OPENSSL" x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -out certs/server.crt -days 825 -sha256 -extfile certs/san.cnf 2>/dev/null

echo
echo "完成。SAN = $SAN"
"$OPENSSL" x509 -in certs/server.crt -noout -subject -ext subjectAltName
echo
echo "接下来："
echo "  1) .env 填 HTTPS_CERT=certs/server.crt  HTTPS_KEY=certs/server.key  HTTPS_PORT=8443"
echo "  2) npm run build --workspace web && node server/src/index.js"
echo "  3) 手机浏览器先把 certs/ca.crt 装成受信任 CA，再访问 https://<IP>:8443"
