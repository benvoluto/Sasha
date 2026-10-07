export const Typography = ({ variant, classes, children }: { variant: string; classes?: string | undefined; children: React.ReactNode }) => {
  const classString = `${classes ? classes : ''}`;
  return (
    <span className={`${variant} ${classString}`}>
      {children}
    </span>
  );
};
