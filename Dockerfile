FROM node:20-alpine AS builder

WORKDIR /app

# Copier les fichiers de configuration
COPY package*.json ./
COPY tsconfig.json ./

# Installer les dépendances
RUN npm ci

# Copier le code source
COPY server/ ./server/

# Construire l'application
RUN npm run build

# Image de production
FROM node:20-alpine

WORKDIR /app

# Copier package.json et installer uniquement les dépendances de production
COPY package*.json ./
RUN npm ci --only=production

# Copier les fichiers compilés depuis le builder
COPY --from=builder /app/server/dist ./server/dist

# Exposer le port
EXPOSE 3000

# Variable d'environnement pour le port
ENV PORT=3000

# Commande de démarrage
CMD ["node", "server/dist/index.js"]


