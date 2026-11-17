"""產生 Web Push 用的 VAPID 金鑰，印出來貼到 .env。

    uv run --with cryptography python -m tools.gen_vapid

換掉金鑰後，所有人的訂閱都會失效，要在行程頁「回報」分頁重新開啟通知。
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


if __name__ == "__main__":
    k = ec.generate_private_key(ec.SECP256R1())
    print("VAPID_PUBLIC_KEY=" + b64(k.public_key().public_bytes(serialization.Encoding.X962,
                                                                serialization.PublicFormat.UncompressedPoint)))
    print("VAPID_PRIVATE_KEY=" + b64(k.private_numbers().private_value.to_bytes(32, "big")))
