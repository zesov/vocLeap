import NavBar from "@/components/NavBar";
import { ReviewSession } from "@/components/ReviewSession";

export default function ReviewPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <p className="text-gray-600 dark:text-gray-400 text-center mb-8">
          Practice your saved words with spaced repetition
        </p>
        <ReviewSession />
      </div>
    </div>
  );
}