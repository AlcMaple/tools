import { useState } from "react";

export function ImagePlaceholder({
  className = "",
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`bg-surface-container-high flex items-center justify-center ${className}`}
    >
      <span className="material-symbols-outlined text-on-surface-variant/20 text-4xl">
        movie
      </span>
    </div>
  );
}

export function CoverImage({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): JSX.Element {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return <ImagePlaceholder className="w-full h-full" />;
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      className="w-full h-full object-cover"
      onError={() => setHasError(true)}
    />
  );
}
