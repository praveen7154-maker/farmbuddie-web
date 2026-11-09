FROM python:3.11-slim

# rasterio's wheel bundles GDAL but links the system expat (not in -slim).
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Fail the build, not the container, if a library can't load.
RUN python -c "import rasterio, numpy, shapely, pyproj, PIL, psycopg; print('libraries ok, GDAL', rasterio.__gdal_version__)"

COPY ndvi_worker ./ndvi_worker

RUN useradd --system --no-create-home ndvi
USER ndvi

CMD ["python", "-m", "ndvi_worker", "run"]
