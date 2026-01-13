/**
 * Return standard animation CSS available to all templates.
 */
export const getStandardAnimationCss = (): string => `
/* Standard Animation Classes - Always Available */
/* Fade animations with different easing functions */
.root.state-enter.anim-ease [data-animate] {
  animation-name: fade-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease;
  animation-fill-mode: both;
}

.root.state-exit.anim-ease [data-animate] {
  animation-name: fade-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease;
  animation-fill-mode: both;
}

.root.state-enter.anim-ease-in [data-animate] {
  animation-name: fade-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-in;
  animation-fill-mode: both;
}

.root.state-exit.anim-ease-in [data-animate] {
  animation-name: fade-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-in;
  animation-fill-mode: both;
}

.root.state-enter.anim-ease-out [data-animate] {
  animation-name: fade-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-ease-out [data-animate] {
  animation-name: fade-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-enter.anim-ease-in-out [data-animate] {
  animation-name: fade-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-in-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-ease-in-out [data-animate] {
  animation-name: fade-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-in-out;
  animation-fill-mode: both;
}

.root.state-enter.anim-linear [data-animate] {
  animation-name: fade-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: linear;
  animation-fill-mode: both;
}

.root.state-exit.anim-linear [data-animate] {
  animation-name: fade-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: linear;
  animation-fill-mode: both;
}

/* Slide animations */
.root.state-enter.anim-slide-up [data-animate] {
  animation-name: slide-up-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-slide-up [data-animate] {
  animation-name: slide-up-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-enter.anim-slide-down [data-animate] {
  animation-name: slide-down-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-slide-down [data-animate] {
  animation-name: slide-down-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-enter.anim-slide-left [data-animate] {
  animation-name: slide-left-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-slide-left [data-animate] {
  animation-name: slide-left-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-enter.anim-slide-right [data-animate] {
  animation-name: slide-right-enter;
  animation-duration: var(--anim-dur-enter, 450ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

.root.state-exit.anim-slide-right [data-animate] {
  animation-name: slide-right-exit;
  animation-duration: var(--anim-dur-exit, 300ms);
  animation-timing-function: ease-out;
  animation-fill-mode: both;
}

@keyframes fade-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fade-exit {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes slide-up-enter {
  from { transform: translateY(var(--anim-distance, 40px)); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes slide-up-exit {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(var(--anim-distance, 40px)); opacity: 0; }
}

@keyframes slide-down-enter {
  from { transform: translateY(calc(var(--anim-distance, 40px) * -1)); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes slide-down-exit {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(calc(var(--anim-distance, 40px) * -1)); opacity: 0; }
}

@keyframes slide-left-enter {
  from { transform: translateX(var(--anim-distance, 40px)); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes slide-left-exit {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(var(--anim-distance, 40px)); opacity: 0; }
}

@keyframes slide-right-enter {
  from { transform: translateX(calc(var(--anim-distance, 40px) * -1)); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes slide-right-exit {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(calc(var(--anim-distance, 40px) * -1)); opacity: 0; }
}
`.trim();
