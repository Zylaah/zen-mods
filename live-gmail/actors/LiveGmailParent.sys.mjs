export class LiveGmailParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== 'LiveGmail:ReadState') return;
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    try {
      win?.liveGmail?.onReadState?.(browser);
    } catch (e) {
      console.error('[Live Gmail] read-state:', e);
    }
  }
}
