FROM node:22-alpine

WORKDIR /app
# Reproducible install: package-lock.json is committed and `npm ci` installs the
# EXACT locked tree (and fails loudly if package.json/lock drift). This is what
# makes the deployed image match the audited dependency tree — in particular it
# carries backend/package.json's `overrides` (e.g. uuid>=11.1.1), which a bare
# `npm install` here would silently re-resolve away. Copying the lock explicitly
# (not package*.json) fails the build if it is ever missing. See BACKLOG HARDEN-1.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "functions-framework", "--target=api", "--port=8080"]
