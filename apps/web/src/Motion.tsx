"use client";

import { useEffect } from "react";

/**
 * Progressive-enhancement motion layer for the homepage.
 *
 * The `js` class on <html> (added by an inline script in the layout) gates the
 * hidden pre-reveal state, so content is fully visible when scripts never run.
 * Everything here is transform/opacity only and skipped for reduced motion.
 */
export function SiteMotion() {
  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

    // Condense the header once the page scrolls.
    const header = document.querySelector(".site-header");
    const syncHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 24);
    syncHeader();
    window.addEventListener("scroll", syncHeader, { passive: true });

    // Reveal-on-scroll: one shot per element, staggered via the --i custom property.
    // Without IntersectionObserver support, fall back to showing everything.
    const revealEls = Array.from(document.querySelectorAll(".reveal"));
    let revealObserver: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      revealObserver = new window.IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              revealObserver?.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
      );
      for (const el of revealEls) {
        revealObserver.observe(el);
      }
    } else {
      for (const el of revealEls) {
        el.classList.add("is-visible");
      }
    }

    // Hero parallax: the gates lag behind the scroll and drift toward the pointer,
    // smoothed with a lerp so it feels physical rather than wired to the mouse.
    const hero = document.querySelector<HTMLElement>(".hero");
    const layer = document.querySelector<HTMLElement>(".hero-parallax");
    let frame = 0;
    let heroVisible = true;
    let detachParallax = () => {};

    if (hero && layer && !reduceMotion.matches) {
      let targetX = 0;
      let targetY = 0;
      let scrollDrift = 0;
      let x = 0;
      let y = 0;
      let drift = 0;

      const onPointerMove = (event: PointerEvent) => {
        const rect = hero.getBoundingClientRect();
        targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 16;
        targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 10;
      };
      const onScroll = () => {
        scrollDrift = Math.min(window.scrollY * 0.15, 160);
      };
      const tick = () => {
        frame = window.requestAnimationFrame(tick);
        if (!heroVisible) return;
        x += (targetX - x) * 0.06;
        y += (targetY - y) * 0.06;
        drift += (scrollDrift - drift) * 0.09;
        layer.style.transform = `translate3d(${x.toFixed(2)}px, ${(y + drift).toFixed(2)}px, 0)`;
      };

      const visibilityObserver =
        "IntersectionObserver" in window
          ? new window.IntersectionObserver(([entry]) => {
              heroVisible = entry.isIntersecting;
            })
          : undefined;
      visibilityObserver?.observe(hero);

      if (finePointer.matches) {
        hero.addEventListener("pointermove", onPointerMove, { passive: true });
      }
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      frame = window.requestAnimationFrame(tick);

      detachParallax = () => {
        visibilityObserver?.disconnect();
        hero.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("scroll", onScroll);
      };
    }

    return () => {
      window.removeEventListener("scroll", syncHeader);
      revealObserver?.disconnect();
      window.cancelAnimationFrame(frame);
      detachParallax();
    };
  }, []);

  return null;
}
