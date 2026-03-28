FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y \
  git \
  bash \
  curl \
  procps \
  build-essential \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Install Cockpit globally
RUN npm install -g @surething/cockpit

# Clone cockpit source as demo project
RUN git clone --depth 1 https://github.com/Surething-io/cockpit.git /home/user/demo-project

# Set working directory
WORKDIR /home/user/demo-project
