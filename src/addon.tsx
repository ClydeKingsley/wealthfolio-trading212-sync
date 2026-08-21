import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { SyncSettingsPage } from './pages/SyncSettingsPage';
import { SyncController } from './lib/sync-controller';

let addonCtx: AddonContext | undefined;
let syncController: SyncController | undefined;

const SyncSettingsRoute = () => {
  if (!addonCtx || !syncController) return null;
  return (
    <QueryClientProvider client={addonCtx.api.query.getClient() as QueryClient}>
      <SyncSettingsPage controller={syncController} />
    </QueryClientProvider>
  );
};

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;
  syncController = new SyncController(ctx);

  const sidebarItem = ctx.sidebar.addItem({
    id: 'trading212-sync',
    label: 'Trading 212 Sync',
    route: '/addons/trading212-sync',
    icon: 'plugs-connected',
    order: 96,
  });

  ctx.router.add({
    id: 'trading212-sync',
    path: '/addons/trading212-sync',
    title: 'Trading 212 Sync',
    component: SyncSettingsRoute,
  });

  void syncController.initialize();
  ctx.api.logger.info('Trading 212 read-only sync addon loaded.');

  ctx.onDisable(() => {
    syncController?.dispose();
    sidebarItem.remove();
    syncController = undefined;
    addonCtx = undefined;
  });
};

export default enable;
