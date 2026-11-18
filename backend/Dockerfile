FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.32" "redis[hiredis]>=5.2" "httpx>=0.27" "pywebpush>=2.0"
COPY app ./app
COPY tools ./tools
EXPOSE 8750
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8750", "--proxy-headers", "--forwarded-allow-ips", "*"]
