#!/usr/bin/env bash
# Throwaway CA and a non-CA server leaf; shared by CI and the verifier trust test.
set -euo pipefail
work=${1:?Certificate output directory}
sans=${2:?Leaf subjectAltName list}
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=PassGen-Test-CA \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$work/ca-key.pem" -out "$work/ca.pem"
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj /CN=passgen.test \
  -addext basicConstraints=critical,CA:FALSE -addext "subjectAltName=$sans" \
  -addext keyUsage=critical,digitalSignature,keyEncipherment -addext extendedKeyUsage=serverAuth \
  -keyout "$work/key.pem" -out "$work/leaf.csr"
openssl x509 -req -in "$work/leaf.csr" -CA "$work/ca.pem" -CAkey "$work/ca-key.pem" \
  -set_serial 2 -days 1 -sha256 -copy_extensions copy -out "$work/cert.pem"
