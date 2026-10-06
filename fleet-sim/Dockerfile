# Runs Meili Robots' open-source python-simulator, unmodified, against the ACS.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3-tk \
    && rm -rf /var/lib/apt/lists/*

# Optional extra root CAs for networks with HTTPS inspection (see extra-ca/README.md).
COPY --from=extra-ca . /usr/local/share/ca-certificates/
RUN update-ca-certificates
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt

# Pinned upstream commit of https://gitlab.com/meilirobots/public/python-simulator
ARG SIM_REF=36bd94a587dee5502803190a43bfe2d71ac6e435
RUN git clone https://gitlab.com/meilirobots/public/python-simulator.git /sim \
    && git -C /sim checkout --quiet "$SIM_REF"
RUN pip install --no-cache-dir -r /sim/requirements.txt

COPY vehicles_config.json /sim/config/vehicles_config.json
COPY entrypoint.py /entrypoint.py

WORKDIR /sim
ENTRYPOINT ["python3", "-u", "/entrypoint.py"]
