FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "functions-framework", "--target=api", "--port=8080"]
