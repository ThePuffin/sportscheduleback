export const readableDate = (date) => {
  return new Date(date).toISOString().split('T')[0];
};

export const getHourGame = (startTimeUTC, venueUTCOffset) => {
  const timeToRemove = Number(
    venueUTCOffset.replace(':', '.').replace('-', ''),
  );
  const starTime = new Date(startTimeUTC);
  const getCorrectDate = starTime.setHours(starTime.getHours() - timeToRemove);
  const hourStart = new Date(getCorrectDate)
    .getUTCHours()
    .toString()
    .padStart(2, '0');
  const minStart = new Date(getCorrectDate)
    .getMinutes()
    .toString()
    .padStart(2, '0');
  return `${hourStart}:${minStart}`;
};
