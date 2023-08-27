import { createEffect, createMemo, on, onCleanup } from "solid-js";
import { createScheduled, debounce } from "@solid-primitives/scheduled";
import { customElement } from 'solid-element';
import style from './styles/index.css?raw';
import { encodedEntityToFilter, parseUrlPrefixes, updateMetadata } from "./util/ui";
import { nest } from "./util/nest";
import { PreferencesStore, SignersStore, NoteEvent, ZapThreadsContext, db, pool, StoredEvent, StoredProfile } from "./util/stores";
import { Thread } from "./thread";
import { RootComment } from "./reply";
import { createMutable } from "solid-js/store";
import { createDexieArrayQuery } from "solid-dexie";
import { Sub } from "./nostr-tools/relay";
import batchedFunction from 'batched-function';
import { decode as bolt11Decode } from "light-bolt11-decoder";

const ZapThreads = (props: ZapThreadsProps) => {
  if (!['http', 'naddr', 'note', 'nevent'].some(e => props.anchor.startsWith(e))) {
    throw "Only NIP-19 naddr, note and nevent encoded entities and URLs are supported";
  }

  const pubkey = () => props.pubkey;
  const anchor = () => props.anchor;
  const relays = () => props.relays.length > 0 ? props.relays.map(r => new URL(r).toString()) : ["wss://relay.damus.io"];
  const closeOnEose = () => props.closeOnEose;

  const signersStore = createMutable<SignersStore>({});
  const preferencesStore = createMutable<PreferencesStore>({
    disableLikes: props.disableLikes || false,
    disableZaps: props.disableZaps || false,
    disablePublish: props.disablePublish || false,
    urlPrefixes: parseUrlPrefixes(props.urlPrefixes),
  });

  let sub: Sub | null;

  // Only update when anchor or relay props change
  createEffect(on([anchor, relays], async () => {
    if (anchor().startsWith('http')) {
      const eventsForUrl = await pool.list(relays(), [
        { '#r': [anchor()], kinds: [1] }
      ]);
      const eventIdsForUrl = eventsForUrl.map((e) => e.id);
      preferencesStore.filter = { "#e": eventIdsForUrl };
    } else {
      preferencesStore.filter = encodedEntityToFilter(anchor());
    }
  }));

  const filter = () => preferencesStore.filter;

  createEffect(on([filter, relays], async () => {
    if (!filter()) return;

    // Ensure clean subs
    sub?.unsub();
    sub = null;
    onCleanup(() => {
      console.log('unsub!');
      sub?.unsub();
      sub = null;
    });

    const kinds = [1];
    if (preferencesStore.disableLikes === false) {
      kinds.push(7);
    }
    if (preferencesStore.disableZaps === false) {
      kinds.push(9735);
    }

    try {
      // Calculate relay/anchor pairs with different supplied relays and current anchor
      const urlAnchorPairs = relays().map(r => [r, anchor()]);
      const result = await db.relays.where('[url+anchor]').anyOf(urlAnchorPairs).toArray();
      const relaysLatest = result.map(t => t.latest);

      // TODO Do not use the common minimum, pass each relay's latest as its since
      // (but we need to stop using this pool)
      const since = relaysLatest.length > 0 ? Math.min(...relaysLatest) : 0;

      // console.log('opening sub with', JSON.stringify(filter()));

      sub = pool.sub(relays(), [{ ...filter(), kinds, since: since }]);

      const batched = batchedFunction(async (evs: StoredEvent[]) => {
        await db.events.bulkPut(evs);
        await calculateRelayLatest(evs);
      }, { delay: 200 });

      sub.on('event', async (e) => {
        if (e.kind === 1) {
          batched({
            id: e.id,
            kind: e.kind,
            content: e.content,
            created_at: e.created_at,
            pubkey: e.pubkey,
            tags: e.tags,
            anchor: anchor()
          });
        } else if (e.kind === 7) {
          batched({
            id: e.id,
            kind: 7,
            pubkey: e.pubkey,
            created_at: e.created_at,
            anchor: anchor()
          });
        } else if (e.kind === 9735) {
          const invoiceTag = e.tags.find(t => t[0] === "bolt11");
          if (invoiceTag) {
            const decoded = bolt11Decode(invoiceTag[1]);
            const amount = decoded.sections.find((e: { name: string; }) => e.name === 'amount');

            batched({
              id: e.id,
              kind: 9735,
              pubkey: e.pubkey,
              created_at: e.created_at,
              amount: Number(amount.value) / 1000,
              anchor: anchor()
            });
          }
        }
      });

      sub.on('eose', async () => {
        setTimeout(async () => {
          const authorPubkeys = events.map(e => e.pubkey);
          const result = await pool.list(relays(), [{
            kinds: [0],
            authors: [...new Set(authorPubkeys)] // Set makes pubkeys unique
          }]);
          updateMetadata(result);
        }, 200);

        if (closeOnEose()) {
          sub?.unsub();
          pool.close(relays());
        }
      });
    } catch (e) {
      // TODO properly handle error
      console.log(e);
    }
  }));

  const calculateRelayLatest = async (evs: StoredEvent[]) => {
    // Calculate latest created_at to be used as `since` on subsequent relay requests
    if (evs.length > 0) {
      const anchor = evs[0].anchor;
      const obj: { [url: string]: number; } = {};
      for (const e of events) {
        const relaysForEvent = pool.seenOn(e.id);
        for (const url of relaysForEvent) {
          if (e.created_at > (obj[url] || 0)) {
            obj[url] = e.created_at;
          }
        }
      }

      const relays = await db.relays.where('anchor').equals(anchor).toArray();
      for (const url in obj) {
        const relay = relays.find(r => r.url === url);
        if (relay) {
          if (obj[url] > relay.latest) {
            relay.latest = obj[url];
            db.relays.put(relay);
          }
        } else {
          db.relays.put({ url, anchor, latest: obj[url] });
        }
      }
    }
  };

  ///

  const events = createDexieArrayQuery(async () => {
    return await db.events.where('[kind+anchor]').equals([1, anchor()]).toArray() as NoteEvent[];
  });

  const scheduledDebounce = createScheduled(fn => debounce(fn, 160));
  const debouncedEvents = createMemo((e: NoteEvent[] = []) => {
    if (scheduledDebounce() && events.length > 0) {
      return events;
    }
    return e;
  });
  const nestedEvents = () => nest(debouncedEvents());

  const commentsLength = () => debouncedEvents().length;

  return <div id="ztr-root">
    <style>{style}</style>
    <ZapThreadsContext.Provider value={{ relays, anchor, pubkey, signersStore, preferencesStore }}>
      <RootComment />
      <h2 id="ztr-title">
        {commentsLength() > 0 && `${commentsLength()} comment${commentsLength() == 1 ? '' : 's'}`}
      </h2>
      {/* <Show when={!preferencesStore.disableZaps}>
        <h3 id="ztr-subtitle">Z sats</h3>
      </Show> */}
      <Thread nestedEvents={nestedEvents} />
    </ZapThreadsContext.Provider>
  </div>;
};

export default ZapThreads;

type ZapThreadsProps = {
  anchor: string,
  pubkey: string,
  relays: string[];
  closeOnEose: boolean;
  disableLikes?: boolean,
  disableZaps?: boolean,
  disablePublish?: boolean,
  urlPrefixes?: string,
};

customElement('zap-threads', {
  relays: "",
  anchor: "",
  'disable-likes': "",
  'disable-zaps': "",
  'disable-publish': "",
  'pubkey': "",
  'close-on-eose': "",
  'url-prefixes': ""
}, (props) => {
  const relays = props.relays === "" ? [] : props.relays.split(",");
  return <ZapThreads
    anchor={props.anchor}
    pubkey={props.pubkey}
    relays={relays}
    closeOnEose={!!props['close-on-eose']}
    disableLikes={!!props['disable-likes']}
    disableZaps={!!props['disable-zaps']}
    disablePublish={!!props['disable-publish']}
    urlPrefixes={props['url-prefixes']}
  />;
});