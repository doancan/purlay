/** Expiry controls show device-local calendar/time and send an unambiguous UTC instant. */
const pad = (value: number): string => String(value).padStart(2, '0');

export const guestExpiryFields = (
  instant: string,
): { readonly day: string; readonly time: string } => {
  const at = new Date(instant);
  return {
    day: `${String(at.getFullYear()).padStart(4, '0')}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
};

export const guestExpiryInstant = (day: string, time: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const at = new Date(`${day}T${time}:00`);
  if (Number.isNaN(at.getTime())) return null;
  // Date normalizes a nonexistent day or a DST gap; a typed choice must never silently move.
  const normalized = guestExpiryFields(at.toISOString());
  if (normalized.day !== day || normalized.time !== time) return null;
  return at.toISOString();
};
