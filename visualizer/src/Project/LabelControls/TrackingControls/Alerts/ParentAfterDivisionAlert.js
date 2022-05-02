import Alert from '@mui/material/Alert';
import { useSelector } from '@xstate/react';
import React from 'react';
import { useDivision, useLineage } from '../../../ProjectContext';
import { formatFrames, parentAfterDivision } from '../trackingUtils';
import AlertGroup, { alertStyle } from './AlertGroup';

function ParentAfterDivisionAlert({ label }) {
  const { divisionFrame, frames } = useDivision(label);

  const framesAfterDivision = frames.filter((frame) => frame >= divisionFrame);
  const frameText = formatFrames(framesAfterDivision);

  return (
    <Alert sx={alertStyle} severity='error'>
      Parent {label} in {frameText} after division in frame {divisionFrame}.
    </Alert>
  );
}

function ParentAfterDivisionAlerts() {
  const lineageMachine = useLineage();
  const lineage = useSelector(lineageMachine, (state) => state.context.lineage);

  const parentAfterDivisionAlerts = Object.values(lineage)
    .filter((cell) => parentAfterDivision(cell))
    .map((cell) => cell.label);
  const count = parentAfterDivisionAlerts.length;

  const header =
    count === 1 ? `1 parent present after division` : `${count} parents present after division`;

  return (
    count > 0 && (
      <AlertGroup header={header} severity={'error'}>
        {parentAfterDivisionAlerts.map((label) => (
          <ParentAfterDivisionAlert label={label} />
        ))}
      </AlertGroup>
    )
  );
}

export default ParentAfterDivisionAlerts;
