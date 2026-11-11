export class LiveGmailParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    try {
      if (message.name === 'LiveGmail:ReadState') {
        win?.zenIntegrations?.onReadState?.(browser, message.data);
      } else if (message.name === 'LiveGmail:FeedDocument') {
        win?.zenIntegrations?.onFeedDocument?.(browser, message.data);
      }
    } catch (e) {
      console.error('[Zen Integrations] actor message:', e);
    }
  }
}
