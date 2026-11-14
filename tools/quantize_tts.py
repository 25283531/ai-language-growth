"""把 sherpa-onnx 的 fp32 VITS 模型动态量化为 int8，用于端侧性能评估。

官方发布包 vits-melo-tts-zh_en.tar.bz2 里的 model.int8.onnx 只有 133 字节，
是 Git LFS 指针（LFS 服务器返回 404），所以这里在构建时自行量化：
同一份权重、同一音色，只改精度。
"""

import sys

from onnxruntime.quantization import QuantType, quantize_dynamic


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: quantize_tts.py <fp32.onnx> <int8.onnx>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    # 只量化 MatMul/Gemm 类算子权重（动态量化），卷积保持 fp32，音质风险最低。
    quantize_dynamic(src, dst, weight_type=QuantType.QInt8, extra_options={"EnableSubgraph": False})
    print(f"quantized {src} -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
