# ----------------------------
# Simple Node.js Dockerfile
# (No package.json required)
# ----------------------------

FROM node:20

# App directory
WORKDIR /usr/src/app

# Copy all files
COPY . .

# App port
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]
