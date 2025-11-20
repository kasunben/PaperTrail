import { registerRealtimePlugin } from "../../../platform/src/ws/registry.js";

const channelForProject = (projectId) => `papertrail:${projectId}`;

registerRealtimePlugin((hub) => {
  const subscribe = (client, projectId) => {
    if (!projectId) return;
    hub.subscribeChannel(client, channelForProject(projectId));
  };

  const registerUpdate = (client, payload) => {
    const { projectId } = payload || {};
    if (!projectId) return;
    const message = JSON.stringify({ type: "pt:update", payload });
    hub.broadcastChannel(channelForProject(projectId), message, { exclude: client });
  };

  hub.registerMessageHandler("pt:join", (client, payload) => {
    const { projectId } = payload || {};
    subscribe(client, projectId);
  });

  hub.registerMessageHandler("pt:update", (client, payload) => {
    registerUpdate(client, payload);
  });
});
