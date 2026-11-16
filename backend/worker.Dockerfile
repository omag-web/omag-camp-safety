# The Ranger worker: rebuilds the statute library (needs pdftotext) and runs answer checks.
# Built by `sam build` with the repository root as its context (see template.yaml).
FROM public.ecr.aws/lambda/nodejs:22

RUN (microdnf install -y poppler-utils && microdnf clean all) || (dnf install -y poppler-utils && dnf clean all)

WORKDIR ${LAMBDA_TASK_ROOT}
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund
COPY backend/src backend/src
COPY backend/eval backend/eval
COPY backend/data backend/data
COPY knowledge knowledge

CMD ["backend/src/worker.handler"]
