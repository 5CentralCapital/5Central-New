import { useState, useEffect, useRef } from 'react';

interface UseAnimatedCounterOptions {
  duration?: number;
  delay?: number;
  decimals?: number;
  startOnMount?: boolean;
}

export function useAnimatedCounter(
  endValue: number,
  options: UseAnimatedCounterOptions = {}
) {
  const {
    duration = 2000,
    delay = 0,
    decimals = 0,
    startOnMount = true
  } = options;

  const [value, setValue] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const frameRef = useRef<number>();
  const startTimeRef = useRef<number>();

  const start = () => {
    if (hasStarted) return;
    setHasStarted(true);
  };

  useEffect(() => {
    if (startOnMount) {
      const timeoutId = setTimeout(() => {
        setHasStarted(true);
      }, delay);
      return () => clearTimeout(timeoutId);
    }
  }, [startOnMount, delay]);

  useEffect(() => {
    if (!hasStarted || !endValue) return;

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = timestamp;
      }

      const progress = Math.min((timestamp - startTimeRef.current) / duration, 1);

      // Easing function: easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);

      setValue(eased * endValue);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [hasStarted, endValue, duration]);

  return {
    value: Number(value.toFixed(decimals)),
    start,
    hasStarted
  };
}

export function useInViewCounter(
  endValue: number,
  options: UseAnimatedCounterOptions = {}
) {
  const [isInView, setIsInView] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);

  const counter = useAnimatedCounter(endValue, {
    ...options,
    startOnMount: false
  });

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isInView) {
          setIsInView(true);
          counter.start();
        }
      },
      { threshold: 0.3 }
    );

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => observer.disconnect();
  }, [isInView]);

  return {
    ...counter,
    ref: elementRef
  };
}
