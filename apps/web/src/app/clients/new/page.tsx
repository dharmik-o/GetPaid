import Link from "next/link";
import { ClientForm } from "@/components/ClientForm";
import { allTimeZones, COUNTRIES } from "@/lib/countries";

const NewClientPage = () => (
  <div className="page">
    <div className="page-header">
      <h1>Add client</h1>
      <Link href="/clients">Back to clients</Link>
    </div>
    <div className="card">
      <ClientForm countries={[...COUNTRIES]} allTimeZones={allTimeZones()} />
    </div>
  </div>
);

export default NewClientPage;
