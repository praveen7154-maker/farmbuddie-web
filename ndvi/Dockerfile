FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ndvi_worker ./ndvi_worker

RUN useradd --system --no-create-home ndvi
USER ndvi

CMD ["python", "-m", "ndvi_worker", "run"]
