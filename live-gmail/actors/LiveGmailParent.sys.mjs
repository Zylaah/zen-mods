export class LiveGmailParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    try {
      if (message.name === 'LiveGmail:ReadState') {
        win?.liveGmail?.onReadState?.(browser);
      } else if (message.name === 'LiveGmail:FeedDocument') {
        win?.liveGmail?.onFeedDocument?.(browser, message.data);
      }
    } catch (e) {
      console.error('[Live Gmail] actor message:', e);
    }
  }
}
