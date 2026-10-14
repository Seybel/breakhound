<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const { page } = useData();
const open = ref(false);
const copied = ref<'idle' | 'done' | 'failed'>('idle');
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);

/** The page's Markdown, which the build publishes next to its HTML. */
const markdownPath = computed(() => withBase(`/${page.value.relativePath}`));
const markdownUrl = computed(() =>
  typeof window === 'undefined' ? '' : new URL(markdownPath.value, window.location.href).href,
);
const ask = (base: string) =>
  `${base}${encodeURIComponent(`Read ${markdownUrl.value} so I can ask questions about it.`)}`;

async function copy(): Promise<void> {
  open.value = false;
  try {
    const res = await fetch(markdownPath.value);
    if (!res.ok) throw new Error(String(res.status));
    await navigator.clipboard.writeText(await res.text());
    copied.value = 'done';
  } catch {
    copied.value = 'failed';
  }
  setTimeout(() => {
    copied.value = 'idle';
  }, 1600);
}

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    menu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
}

function onPointer(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onKey(event: KeyboardEvent): void {
  if (!open.value) return;
  const items = Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape') {
    open.value = false;
    root.value?.querySelector<HTMLElement>('.toggle')?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointer);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="copy-page">
    <div class="split">
      <button type="button" class="main" @click="copy">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></svg>
        <span>{{ copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy page' }}</span>
      </button>
      <button
        type="button"
        class="toggle"
        aria-haspopup="menu"
        :aria-expanded="open"
        aria-label="More ways to use this page"
        @click="toggle"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ flipped: open }"><path d="m6 9 6 6 6-6" /></svg>
      </button>
    </div>

    <div v-if="open" ref="menu" class="menu" role="menu">
      <button type="button" role="menuitem" @click="copy">
        <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></svg></span>
        <span class="text"><span class="title">Copy page</span><span class="note">Copy this page as Markdown for LLMs</span></span>
      </button>
      <a role="menuitem" :href="markdownPath" target="_blank" rel="noopener" @click="open = false">
        <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true" class="filled"><path d="M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z" /></svg></span>
        <span class="text"><span class="title">View as Markdown <span class="out">↗</span></span><span class="note">View this page as plain text</span></span>
      </a>
      <a role="menuitem" :href="ask('https://chatgpt.com/?hints=search&q=')" target="_blank" rel="noopener" @click="open = false">
        <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12Z" /><path d="M9 10.5h6M9 13.5h4" /></svg></span>
        <span class="text"><span class="title">Open in ChatGPT <span class="out">↗</span></span><span class="note">Ask questions about this page</span></span>
      </a>
      <a role="menuitem" :href="ask('https://claude.ai/new?q=')" target="_blank" rel="noopener" @click="open = false">
        <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true" class="filled"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" /></svg></span>
        <span class="text"><span class="title">Open in Claude <span class="out">↗</span></span><span class="note">Ask questions about this page</span></span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.copy-page {
  position: relative;
  float: right;
  z-index: 10;
  margin: 4px 0 12px 16px;
}
/* On phones it gets a line of its own, so the page title keeps the full width. */
@media (max-width: 639px) {
  .copy-page {
    float: none;
    display: flex;
    justify-content: flex-end;
    margin: 0 0 12px;
  }
}
.split {
  display: flex;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.split button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  border-radius: 9px;
  transition: background-color 0.2s;
}
.split button:hover {
  background: var(--vp-c-default-soft);
}
.split .toggle {
  padding: 0 9px;
  border-left: 1px solid var(--vp-c-divider);
  border-radius: 0 9px 9px 0;
}
.split .main {
  border-radius: 9px 0 0 9px;
}
svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
svg.filled {
  fill: currentColor;
  stroke: none;
}
.toggle svg {
  transition: transform 0.2s;
}
.toggle svg.flipped {
  transform: rotate(180deg);
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: min(320px, calc(100vw - 32px));
  padding: 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-3);
}
.menu [role='menuitem'] {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 10px;
  text-align: left;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.menu [role='menuitem']:hover,
.menu [role='menuitem']:focus-visible {
  background: var(--vp-c-default-soft);
  outline: none;
}
.icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
}
.note {
  font-size: 13px;
  line-height: 1.4;
  color: var(--vp-c-text-2);
}
.out {
  color: var(--vp-c-text-3);
  font-size: 12px;
}
</style>
