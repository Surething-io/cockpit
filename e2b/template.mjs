import { Template, defaultBuildLogger, waitForPort } from 'e2b';

const template = Template()
  .fromDockerfile(`
FROM node:20-slim

RUN apt-get update && apt-get install -y \\
  git bash curl procps build-essential python3 \\
  && rm -rf /var/lib/apt/lists/*

# RUN-layer stdout lands in the build log, so the echo makes each build report
# which version 'latest' resolved to. Otherwise the log says only "added N
# packages" and every build looks alike.
RUN npm install -g @surething/cockpit@latest \\
  && echo "INSTALLED @surething/cockpit@$(cock --version)"

RUN git clone --depth 1 https://github.com/Surething-io/cockpit.git /home/user/demo-project

ENV COCKPIT_HOST=0.0.0.0

WORKDIR /home/user/demo-project
`)
  .setStartCmd('cock /home/user/demo-project --no-open', waitForPort(3457));

const buildInfo = await Template.build(template, 'cockpit-demo', {
  skipCache: true,
  onBuildLogs: defaultBuildLogger(),
});

console.log('Template built successfully!');
console.log('Name:', buildInfo.name);
console.log('Template ID:', buildInfo.templateId);
console.log('Build ID:', buildInfo.buildId);
