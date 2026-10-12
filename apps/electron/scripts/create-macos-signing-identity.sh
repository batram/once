#!/bin/sh
# Creates a self-signed code signing identity in the login Keychain for local
# macOS packages. Packaging signs with it when it exists (see the postPackage
# hook in forge.config.js), so every rebuilt package keeps the same signature
# identity and the "<app name> Safe Storage" Keychain item stays trusted after
# one "Always Allow", instead of prompting after every package.
set -eu

NAME="${ONCE_MACOS_SIGN_IDENTITY:-Once Local Code Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "\"$NAME\" is already in the login Keychain."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.conf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# The system LibreSSL writes a PKCS#12 that `security import` accepts; the
# OpenSSL 3 default (AES/PBKDF2) is rejected.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/cert.conf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem"
PASSWORD="$(/usr/bin/openssl rand -hex 16)"
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$NAME" -passout "pass:$PASSWORD" -out "$WORK/identity.p12"

# -T lets codesign use the private key without a prompt per signature.
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$PASSWORD" \
  -T /usr/bin/codesign

echo "Created \"$NAME\". The next package is signed with it; allow the first"
echo "Keychain prompt of that build with \"Always Allow\"."
