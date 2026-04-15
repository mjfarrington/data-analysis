#!/usr/bin/env bash
# Generate gRPC Python stubs from proto files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_DIR="$SCRIPT_DIR/proto"
OUT_DIR="$SCRIPT_DIR/generated"

mkdir -p "$OUT_DIR"
touch "$OUT_DIR/__init__.py"

python3 -m grpc_tools.protoc \
    -I "$PROTO_DIR" \
    --python_out="$OUT_DIR" \
    --grpc_python_out="$OUT_DIR" \
    "$PROTO_DIR/data_extract.proto"

# Fix relative imports in generated files (grpc_tools quirk)
sed -i '' 's/^import data_extract_pb2/from . import data_extract_pb2/' \
    "$OUT_DIR/data_extract_pb2_grpc.py" 2>/dev/null || \
sed -i 's/^import data_extract_pb2/from . import data_extract_pb2/' \
    "$OUT_DIR/data_extract_pb2_grpc.py"

echo "gRPC stubs generated in $OUT_DIR"
ls -la "$OUT_DIR"
