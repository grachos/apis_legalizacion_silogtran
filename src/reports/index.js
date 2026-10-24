// Report catalog. Field names confirmed from the Silogtran page HTML (2026-10-24).
// Optional filters (conductor, placa, cliente, ruta) are PRADO autocompletes that also need
// their $IDHidden value; not exposed yet.
export const REPORTS = {
  'legalizacion-viaje': {
    title: 'Informe Legalización Viaje',
    page: 'index.php?page=Despacho.Legalizacionviaje_017.InformeLegalizacionViaje',
    fields: {
      startDate: 'ctl0$MainModule$viaemp_fechainicial',
      endDate: 'ctl0$MainModule$viaemp_fechafinal',
      printType: 'ctl0$MainModule$manifiesto_tipoimpresion', // PDF | HTML | CSV | XML | XLS
      printValue: 'CSV',
      button: 'ctl0$MainModule$imprimir',
    },
  },
  'legalizacion-sap': {
    title: 'Informe Legalización SAP',
    page: 'index.php?page=Despacho.Legalizacionviaje_017.InformeLegalizacionSAP',
    fields: {
      startDate: 'ctl0$MainModule$viaemp_fechainicial',
      endDate: 'ctl0$MainModule$viaemp_fechafinal',
      button: 'ctl0$MainModule$ctl3',
    },
  },
};
