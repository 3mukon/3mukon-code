import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// How many rows show before Show More, and at each press of it.
export const ROWS = 500;

// A CSV or TSV file as a table (ADR-0018), its first row the header, a page of rows at a time. A
// cell's whole text shows in its tooltip where the column cuts it.
export function DataTable({ rows }: { rows: string[][] }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(ROWS);
  const [header = [], ...body] = rows;
  const width = Math.max(header.length, ...body.slice(0, shown).map((row) => row.length));
  const cell = 'max-w-[24rem] truncate border border-line px-2 py-1 text-left align-top';
  return (
    <div className="text-[12px] select-text">
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              {Array.from({ length: width }, (_, index) => (
                <th key={index} title={header[index]} className={`${cell} paper-well font-medium`}>
                  {header[index]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, shown).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: width }, (_, index) => (
                  <td key={index} title={row[index]} className={cell}>
                    {row[index]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > shown && (
        <button
          type="button"
          onClick={() => {
            setShown(shown + ROWS);
          }}
          className="mt-2 rounded-sm px-1 text-faint hover:bg-hover hover:text-ink"
        >
          {t('files.table.more', {
            count: Math.min(ROWS, body.length - shown),
            left: body.length - shown,
          })}
        </button>
      )}
    </div>
  );
}
