FROM node:latest

WORKDIR /usr/src/app

COPY ./package.json ./

# Install dependencies
RUN npm install

# Install NestJS CLI globally (optional)
RUN npm install -g @nestjs/cli 

COPY . .

# Build the application
RUN npm run build

# Set environment variables (optional, can also be set in docker-compose.yml).
ENV DATABASE_URI=mongodb://mongodb:27017/sportSchedule
ENV DATABASE_NAME=sportSchedule
ENV DATABASE_USER=
ENV DATABASE_PASS=

# Expose necessary ports
EXPOSE 3000

# Command to start the backend application
CMD ["node", "dist/main.js"] 
